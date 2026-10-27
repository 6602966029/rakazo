# Payments

Bots can buy things with their user's wallet. Each user connects their own wallet, and every purchase asks them to approve it in the wallet provider's app or page before any card exists. The card number and security code are typed straight into the merchant's checkout page; they never reach the model, chat history, tool results, or logs.

The default is `PAYMENT_WALLET_PROVIDER=none`. Core workflows do not require a wallet, and with none configured users see nothing related to payments.

## Enable Link

Configure the API and worker with the same values:

```dotenv
PAYMENT_WALLET_PROVIDER=link
# Optional. Defaults to Link's public sign-in client.
PAYMENT_WALLET_CLIENT_ID=
```

Users then see a Link connect button in Settings. Connecting opens Link's sign-in page with a code to confirm. Once connected, bots get `request_purchase` and `purchase_status`. Each request names the merchant, amount, and reason; the user approves or denies it in Link. Approval issues a single-use card for that purchase.

Link is available to users in the US and Canada only.

Unknown or blank values fall back to `none` instead of failing at boot.

## Card fill limits

The bot fills the card only into a text field on the purchase's own merchant origin over HTTPS. It cannot fill card fields inside cross-origin iframes, such as embedded payment widgets hosted by a payment processor. On those checkouts the purchase is approved but the bot cannot complete it.

## Disconnecting

Disconnecting in Settings revokes the connection with the provider. If the provider revokes it first (for example, the user signs out of the connection in Link), purchase tools stop working until the user connects again.

## Offline verification

`PAYMENT_WALLET_PROVIDER=emulator` runs an in-process wallet for development and tests. Sign-in completes immediately; purchases are approved on the next status check, and amounts above 1,000.00 are denied. It fills the test card `4242 4242 4242 4242`. A shared conformance suite runs against the emulator and against the Link adapter backed by a fake Link API, without network calls.
