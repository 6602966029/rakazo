import * as z from "zod";
import { IsoDate } from "./ids.js";

export const PaymentWalletStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connecting"),
    verificationUrl: z.string().url(),
    userCode: z.string(),
    expiresAt: IsoDate,
  }),
  z.object({ status: z.literal("connected"), connectedAt: IsoDate }),
]);
export type PaymentWalletStatus = z.infer<typeof PaymentWalletStatusSchema>;

/** Currency amounts in the minor unit, as wallets take them. */
export const PurchaseRequestInput = z
  .object({
    merchantName: z.string().trim().min(1).max(200),
    merchantUrl: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Use the HTTPS page the purchase is made on"),
    amount: z.number().int().positive().max(100_000_000),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code")
      .transform((value) => value.toLowerCase()),
    reason: z.string().trim().min(100).max(1000),
  })
  .strict();
export type PurchaseRequestInput = z.infer<typeof PurchaseRequestInput>;

export const PurchaseIdInput = z.object({ id: z.string().trim().min(1).max(100) }).strict();

/** Card fields browser_act fill_card types; the bot never sees their values. */
export const PURCHASE_CARD_FIELDS = ["number", "cvc"] as const;
export type PurchaseCardField = (typeof PURCHASE_CARD_FIELDS)[number];
