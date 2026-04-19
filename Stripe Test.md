These are the basic testing objects used for the sandbox.

stripe products create --name="Basic plan" --description="Test. Created with the Stripe CLI"
```json
{
  "id": "prod_ULyE3C5BYshQ5p",
  "object": "product",
  "active": true,
  "attributes": [],
  "created": 1776447271,
  "default_price": null,
  "description": "Test. Created with the Stripe CLI",
  "images": [],
  "livemode": false,
  "marketing_features": [],
  "metadata": {},
  "name": "Basic plan",
  "package_dimensions": null,
  "shippable": null,
  "statement_descriptor": null,
  "tax_code": null,
  "tax_details": null,
  "type": "service",
  "unit_label": null,
  "updated": 1776447271,
  "url": null
}
```

stripe prices create --unit-amount=40000 --currency=usd --product="prod_ULyE3C5BYshQ5p"
```json
{
  "id": "price_1TNGKUKkFs1y9M8NjPvQbQCr",
  "object": "price",
  "active": true,
  "billing_scheme": "per_unit",
  "created": 1776447442,
  "currency": "usd",
  "custom_unit_amount": null,
  "livemode": false,
  "lookup_key": null,
  "metadata": {},
  "nickname": null,
  "product": "prod_ULyE3C5BYshQ5p",
  "recurring": null,
  "tax_behavior": "unspecified",
  "tiers_mode": null,
  "transform_quantity": null,
  "type": "one_time",
  "unit_amount": 40000,
  "unit_amount_decimal": "40000"
}
```
stripe webhook_endpoints create --enabled-events=* --url="https://quickflip-get-product-ebay-api.netlify.app/.netlify/functions/stripeWebhook"
{
  "id": "we_1TNiwoKkFs1y9M8NvFiFcWTc",
  "object": "webhook_endpoint",
  "api_version": null,
  "application": null,
  "created": 1776557450,
  "description": null,
  "enabled_events": ["*"],
  "livemode": false,
  "metadata": {},
  "secret": "whsec_3z54qbTpz21rJADhLWT3qtLawvIaRivl",
  "status": "enabled",
  "url": "https://quickflip-get-product-ebay-api.netlify.app/.netlify/functions/stripeWebhook"
}

<!-- stripe webhook_endpoints create --enabled-events="charge.succeeded charge.failed charge.refunded charge.dispute.created charge.dispute.closed payment_intent.created payment_intent.succeeded payment_intent.payment_failed payment_intent.canceled payment_intent.requires_action customer.created customer.updated customer.deleted customer.subscription.created customer.subscription.updated customer.subscription.deleted customer.subscription.trial_will_end customer.subscription.paused customer.subscription.resumed invoice.created invoice.finalized invoice.paid invoice.payment_failed invoice.payment_action_required invoice.upcoming invoice.voided payment_method.attached payment_method.detache" --url="https://quickflip-get-product-ebay-api.netlify.app/.netlify/functions/stripeWebhook"

stripe webhook_endpoints create --url="https://quickflip-get-product-ebay-api.netlify.app/.netlify/functions/stripeWebhook" -d "enabled_events[0]"="charge.succeeded" -d "enabled_events[1]"="charge.failed" -d "enabled_events[2]"="charge.refunded" -d "enabled_events[3]"="charge.dispute.created" -d "enabled_events[4]"="charge.dispute.closed" -d "enabled_events[5]"="payment_intent.created" -d "enabled_events[6]"="payment_intent.succeeded" -d "enabled_events[7]"="payment_intent.payment_failed" -d "enabled_events[8]"="payment_intent.canceled" -d "enabled_events[9]"="payment_intent.requires_action" -d "enabled_events[10]"="customer.created" -d "enabled_events[11]"="customer.updated" -d "enabled_events[12]"="customer.deleted" -d "enabled_events[13]"="customer.subscription.created" -d "enabled_events[14]"="customer.subscription.updated" -d "enabled_events[15]"="customer.subscription.deleted" -d "enabled_events[16]"="customer.subscription.trial_will_end" -d "enabled_events[17]"="customer.subscription.paused" -d "enabled_events[18]"="customer.subscription.resumed" -d "enabled_events[19]"="invoice.created" -d "enabled_events[20]"="invoice.finalized" -d "enabled_events[21]"="invoice.paid" -d "enabled_events[22]"="invoice.payment_failed" -d "enabled_events[23]"="invoice.payment_action_required" -d "enabled_events[24]"="invoice.upcoming" -d "enabled_events[25]"="invoice.voided" -d "enabled_events[26]"="payment_method.attached" -d "enabled_events[27]"="payment_method.detached" -->