/**
 * The operator-configured public label, or undefined when none is configured.
 *
 * Distinct from `publicModelLabelFor`, which falls back to the internal label so headers and
 * prompts always have a name to print. Redaction must use THIS one: with no label configured
 * there is nothing to hide, and "redacting" internal labels to another internal label only
 * mis-attributes the review (measured 2026-09-20: the validator's `deepseek-v4-pro-0813` was
 * rewritten to the primary model's `deepseek-v4.1-flash` in every public council comment).
 */
export function configuredPublicModelLabel(
  env: { ELEK_PUBLIC_MODEL_LABEL?: string } = process.env,
): string | undefined {
  const label = env.ELEK_PUBLIC_MODEL_LABEL?.trim();
  return label || undefined;
}

export function publicModelLabelFor(
  internalModelLabel: string,
  env: { ELEK_PUBLIC_MODEL_LABEL?: string } = process.env,
): string {
  const label = env.ELEK_PUBLIC_MODEL_LABEL?.trim();
  return label || internalModelLabel;
}

export function modelLabelRedactionTerms(labels: Array<string | undefined>): string[] {
  const terms = new Set<string>();
  for (const label of labels) {
    const clean = label?.trim();
    if (!clean) continue;
    terms.add(clean);
    const parts = clean.split("/").map((part) => part.trim()).filter(Boolean);
    const tail = parts.at(-1);
    if (tail) terms.add(tail);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}
