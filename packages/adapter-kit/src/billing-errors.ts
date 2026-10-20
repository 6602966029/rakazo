/** The billing provider no longer has this customer, e.g. it was deleted in the vendor's dashboard. */
export class BillingCustomerNotFoundError extends Error {
  readonly code = "BILLING_CUSTOMER_NOT_FOUND";
  constructor(options?: { cause?: unknown }) {
    super("Billing customer no longer exists", options);
    this.name = "BillingCustomerNotFoundError";
  }
}
