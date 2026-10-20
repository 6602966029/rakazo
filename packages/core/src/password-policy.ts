/**
 * Length limits for new passwords (NIST SP 800-63B): no composition rules.
 * Sign-in accepts any stored password, so raising the minimum never locks anyone out.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** iOS AutoFill rules, so a generated password satisfies the server. */
export const PASSWORD_RULES = `minlength: ${MIN_PASSWORD_LENGTH}; maxlength: ${MAX_PASSWORD_LENGTH};`;
