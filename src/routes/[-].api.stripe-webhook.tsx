import { createFileRoute } from "@tanstack/react-router";
import type { SponsorSlotId } from "#/content/sponsors";
import {
	bustSponsorSlotCache,
	getStripeClient,
	sponsorSlotEnv,
} from "#/lib/sponsor";

/**
 * Stripe webhook → POST /-/api/stripe-webhook.
 *
 * A raw `server.handlers` route (like robots.txt / the OG endpoints): router handlers bypass the
 * server-function CSRF middleware, which is correct here — the request comes from Stripe, not our
 * frontend, and the Stripe *signature* is the auth. We verify it against the raw request body
 * before trusting a single field.
 *
 * Single-occupancy: on the first `checkout.session.completed` we deactivate the slot's Payment
 * Link, so a second buyer physically can't reach checkout. Deactivation is idempotent — Stripe
 * retries and duplicate deliveries re-run it harmlessly, so no event-id bookkeeping is needed.
 * A `customer.subscription.deleted` only busts the cache and logs; re-opening the link stays a
 * deliberate manual dashboard toggle (the owner swaps the homepage creative first).
 */

const err = (msg: string, status: number) => new Response(msg, { status });

export const Route = createFileRoute("/-/api/stripe-webhook")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const secret = process.env.STRIPE_WEBHOOK_SECRET;
				const stripe = await getStripeClient();
				// Unconfigured → 400 (not 500): nothing to verify against, and a 400 tells a
				// misconfigured endpoint apart from a genuine server fault in the Stripe dashboard.
				if (!secret || !stripe) return err("Stripe not configured", 400);

				const signature = request.headers.get("stripe-signature");
				if (!signature) return err("Missing stripe-signature", 400);

				// Raw body — constructEventAsync recomputes the HMAC over the exact bytes Stripe
				// signed, so it must be the untouched text, not a re-serialized JSON object.
				const body = await request.text();
				let event: import("stripe").Stripe.Event;
				try {
					event = await stripe.webhooks.constructEventAsync(
						body,
						signature,
						secret,
					);
				} catch {
					return err("Invalid signature", 400);
				}

				try {
					if (event.type === "checkout.session.completed") {
						const session = event.data.object;
						const linkId =
							typeof session.payment_link === "string"
								? session.payment_link
								: (session.payment_link?.id ?? null);
						const env = sponsorSlotEnv();
						const slot = (Object.keys(env) as SponsorSlotId[]).find(
							(id) => linkId !== null && env[id].linkId === linkId,
						);
						const targetLinkId = slot ? env[slot].linkId : undefined;
						if (targetLinkId) {
							// Turn the link off so nobody else can pay. Idempotent: safe to repeat.
							await stripe.paymentLinks.update(targetLinkId, { active: false });
							bustSponsorSlotCache();
						}
					} else if (event.type === "customer.subscription.deleted") {
						bustSponsorSlotCache();
						console.info(
							"[sponsor] subscription deleted — slot freed, awaiting manual re-open",
						);
					}
				} catch (sideEffect) {
					// A Stripe call failing here is likely transient. Return 500 so Stripe retries
					// the (idempotent) deactivation, rather than silently dropping single-occupancy.
					console.error("[sponsor] webhook side-effect failed", sideEffect);
					return err("Webhook handler error", 500);
				}

				return new Response("ok", { status: 200 });
			},
		},
	},
});
