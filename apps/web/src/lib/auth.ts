import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

// organizationClient's type resolves to `any`, which would erase the other plugin's methods.
export const authClient: ReactAuthClient<{
  plugins: [ReturnType<typeof emailOTPClient>];
}> = createAuthClient({
  plugins: [organizationClient(), emailOTPClient()],
});
