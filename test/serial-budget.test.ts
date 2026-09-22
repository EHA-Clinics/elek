/**
 * Tests for the serial wall-clock budget guard (EHAC-2280, AC #4).
 *
 * The guard asserts `setup + 2 * run_timeout_seconds <= job_timeout_minutes * 60`
 * before any model runs. The factor of two is the SERIAL worst case: a council runs
 * its reviewer lenses and the validator runs AFTER them, so two full per-run budgets
 * can elapse back to back.
 *
 * The reason this file exists at all is that a TWO-outcome guard (pass/fail) passes
 * trivially whenever `job_timeout_minutes` is absent — and it is absent by default,
 * on every consumer. That is a gate that cannot fail. So the guard has THREE outcomes
 * and the third one is asserted here by SPYING on the reporter, never by "it did not
 * throw".
 */
import { describe, it, expect } from "bun:test";
import {
  assessSerialBudget,
  reportSerialBudget,
  SETUP_SECONDS,
  type SerialBudgetReporter,
} from "../src/review/serial-budget";
import { parseJobTimeoutMinutesInput, parseValidatorRunTimeoutSecondsInput } from "../src/github/context";

function spyReporter() {
  const calls: { info: string[]; warning: string[]; setFailed: string[] } = {
    info: [],
    warning: [],
    setFailed: [],
  };
  const reporter: SerialBudgetReporter = {
    info: (m) => calls.info.push(m),
    warning: (m) => calls.warning.push(m),
    setFailed: (m) => calls.setFailed.push(m),
  };
  return { reporter, calls };
}

describe("parseValidatorRunTimeoutSecondsInput", () => {
  it("treats an empty value as documented INHERITANCE, not misconfiguration", () => {
    expect(parseValidatorRunTimeoutSecondsInput("")).toBeUndefined();
    expect(parseValidatorRunTimeoutSecondsInput("   ")).toBeUndefined();
  });

  it("parses a well-formed value", () => {
    expect(parseValidatorRunTimeoutSecondsInput("1200")).toBe(1200);
    expect(parseValidatorRunTimeoutSecondsInput(" 900 ")).toBe(900);
  });

  // Throw-on-garbage, per the safety-parser doctrine. This number asserts the
  // serial wall-clock bound; asserting against a misread value is worse than not
  // asserting.
  it.each(["12O", "0", "-1", "12.5", "abc", "1e2", "1200s"])(
    "throws on %p, naming the input",
    (bad) => {
      expect(() => parseValidatorRunTimeoutSecondsInput(bad)).toThrow(/validator_run_timeout_seconds/);
    },
  );

  // ── EHAC-2841: safe-integer range ──────────────────────────────────────────
  // These values digit-parse and Number.isInteger accepts them, but the serial
  // budget guard MULTIPLIES the resolved number; past 2^53 that multiplication
  // silently loses precision, so the asserted fit would not be the real fit.

  it("rejects integers above Number.MAX_SAFE_INTEGER (validator budget)", () => {
    expect(() => parseValidatorRunTimeoutSecondsInput("10000000000000000000"))
      .toThrow(/MAX_SAFE_INTEGER/);
    expect(() => parseValidatorRunTimeoutSecondsInput("9007199254740993")) // 2^53 + 1
      .toThrow(/validator_run_timeout_seconds/);
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER (the boundary is inclusive)", () => {
    expect(parseValidatorRunTimeoutSecondsInput("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("parseJobTimeoutMinutesInput", () => {
  it("treats an empty value as documented ABSENCE, not misconfiguration", () => {
    expect(parseJobTimeoutMinutesInput("")).toBeUndefined();
    expect(parseJobTimeoutMinutesInput("   ")).toBeUndefined();
  });

  it("parses a well-formed value", () => {
    expect(parseJobTimeoutMinutesInput("45")).toBe(45);
    expect(parseJobTimeoutMinutesInput(" 30 ")).toBe(30);
  });

  // Throw-on-garbage, per parseStallTimeoutSecondsInput's doctrine. A safety input
  // that warn-and-ignores is this codebase's documented anti-pattern: it would leave
  // the budget unchecked behind a green log line.
  it.each(["4O", "0", "-1", "12.5", "abc", "1e2", "45m"])(
    "throws on %p, naming the input",
    (bad) => {
      expect(() => parseJobTimeoutMinutesInput(bad)).toThrow(/job_timeout_minutes/);
    },
  );

  it("rejects integers above Number.MAX_SAFE_INTEGER (job cap)", () => {
    expect(() => parseJobTimeoutMinutesInput("10000000000000000000"))
      .toThrow(/MAX_SAFE_INTEGER/);
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER (the boundary is inclusive)", () => {
    expect(parseJobTimeoutMinutesInput("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("assessSerialBudget", () => {
  it("exposes the setup constant it reasons with", () => {
    expect(SETUP_SECONDS).toBe(37);
  });

  it("PASSES the post-EHAC-2280 fleet shape (900s runs inside a 45-minute cap)", () => {
    const r = assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: 45 });
    expect(r.outcome).toBe("pass");
    expect(r.message).toContain("1837");
    expect(r.message).toContain("2700");
  });

  it("FAILS when the per-run budget grew without the cap moving first", () => {
    const r = assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: 30 });
    expect(r.outcome).toBe("fail");
    // The message must carry BOTH configured numbers and BOTH sides of the arithmetic,
    // so the log line is actionable without opening the workflow file.
    for (const n of ["900", "30", "1837", "1800"]) expect(r.message).toContain(n);
  });

  it("PASSES the pre-T2 fleet shape (600s runs inside the inherited 30-minute cap)", () => {
    // 37 + 1200 = 1237 <= 1800. This case is deliberately present so the guard can never
    // be mistaken for a policy about timeout LENGTH. It checks arithmetic, nothing else.
    const r = assessSerialBudget({ runTimeoutSeconds: 600, jobTimeoutMinutes: 30 });
    expect(r.outcome).toBe("pass");
  });

  it("reports UNCHECKED, naming the missing input, when the cap is absent", () => {
    const r = assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: undefined });
    expect(r.outcome).toBe("unchecked");
    expect(r.message).toContain("job_timeout_minutes");
  });

  it("treats the boundary as satisfied (<=, not <)", () => {
    // 37 + 2 * 881.5 -> use an exact fit: cap 1837s is not expressible in whole minutes,
    // so assert the nearest exact case: 37 + 2*400 = 837 <= 840 (14 minutes).
    expect(assessSerialBudget({ runTimeoutSeconds: 400, jobTimeoutMinutes: 14 }).outcome).toBe("pass");
    expect(assessSerialBudget({ runTimeoutSeconds: 400, jobTimeoutMinutes: 13 }).outcome).toBe("fail");
  });

  // ── EHAC-2833: the validator roles carry their own wall clock ────────────────

  it("is BYTE-IDENTICAL when the validator input is unset (2R formula, not the retry-aware one)", () => {
    // Unset means V := R. Using the retry-aware formula there would demand
    // `setup + 3R` from every consumer that has not adopted the input and red
    // previously-passing callers at preflight.
    const r = assessSerialBudget({ runTimeoutSeconds: 600, jobTimeoutMinutes: 30 });
    expect(r.outcome).toBe("pass");
    expect(r.message).toContain("2 x 600");
  });

  it("enforces the retry-aware bound when the validator input is set", () => {
    // 37 + max(2*900, 2*1200) + 1200 = 37 + 2400 + 1200 = 3637 <= 3900 (65 min).
    const r = assessSerialBudget({
      runTimeoutSeconds: 900,
      validatorRunTimeoutSeconds: 1200,
      jobTimeoutMinutes: 65,
    });
    expect(r.outcome).toBe("pass");
    expect(r.message).toContain("3637");
    expect(r.message).toContain("3900");
  });

  it("FAILS when the validator budget grew without the cap moving first", () => {
    // 37 + 2400 + 1200 = 3637 > 3300 (55 min) — the exact shape the caller
    // arithmetic comment in eha_care/ehe-care-infra must never regress into.
    const r = assessSerialBudget({
      runTimeoutSeconds: 900,
      validatorRunTimeoutSeconds: 1200,
      jobTimeoutMinutes: 55,
    });
    expect(r.outcome).toBe("fail");
    for (const n of ["900", "1200", "3637", "3300"]) expect(r.message).toContain(n);
  });

  it("still holds when the validator budget is SMALLER than the reviewer budget", () => {
    // 37 + max(2*900, 2*600) + 600 = 37 + 1800 + 600 = 2437 <= 2700.
    const r = assessSerialBudget({
      runTimeoutSeconds: 900,
      validatorRunTimeoutSeconds: 600,
      jobTimeoutMinutes: 45,
    });
    expect(r.outcome).toBe("pass");
    expect(r.message).toContain("2437");
  });

  // ── EHAC-2841: explicit V == R is a STRICTER OPT-IN, never normalized ───────
  //
  // Unset V means "inherit R" and keeps the legacy `setup + 2R` formula, so
  // callers that never adopted the input stay green. But a caller that types
  // V = R EXPLICITLY has opted into the validator budget, and the honest bound
  // for an opted-in council is the retry-aware `setup + 3R`. Normalizing
  // explicit equality back to `2R` would make the guard report a ceiling the
  // retry path can actually exceed, so the strictness is deliberate and
  // documented here as tests, not just comments.

  it("treats EXPLICIT V == R as stricter than UNSET V (the surprise case, documented)", () => {
    const unset = assessSerialBudget({ runTimeoutSeconds: 600, jobTimeoutMinutes: 30 });
    const explicitEqual = assessSerialBudget({
      runTimeoutSeconds: 600,
      validatorRunTimeoutSeconds: 600,
      jobTimeoutMinutes: 30,
    });
    expect(unset.outcome).toBe("pass"); // 37 + 2*600 = 1237 <= 1800
    expect(explicitEqual.outcome).toBe("fail"); // 37 + 1200 + 600 = 1837 > 1800
    expect(explicitEqual.message).toContain("1837");
  });

  it("explicit V == R passes once the cap actually covers the retry-aware bound", () => {
    // 37 + max(2*900, 2*900) + 900 = 37 + 1800 + 900 = 2737 <= 3900 (65 min).
    const r = assessSerialBudget({
      runTimeoutSeconds: 900,
      validatorRunTimeoutSeconds: 900,
      jobTimeoutMinutes: 65,
    });
    expect(r.outcome).toBe("pass");
    expect(r.message).toContain("2737");
  });

  it("explicit V == R FAILS a cap that the unset form would pass (the trap, asserted)", () => {
    // 37 + 3*900 = 2737 > 2700 (45 min) — the previously-green fleet shape.
    const r = assessSerialBudget({
      runTimeoutSeconds: 900,
      validatorRunTimeoutSeconds: 900,
      jobTimeoutMinutes: 45,
    });
    expect(r.outcome).toBe("fail");
    for (const n of ["900", "2737", "2700"]) expect(r.message).toContain(n);
  });
});

describe("reportSerialBudget", () => {
  it("on PASS: informs, does not warn, does not fail, and continues", () => {
    const { reporter, calls } = spyReporter();
    const decision = reportSerialBudget(
      assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: 45 }),
      reporter,
    );
    expect(decision).toBe("continue");
    expect(calls.info.length).toBe(1);
    expect(calls.warning.length).toBe(0);
    expect(calls.setFailed.length).toBe(0);
  });

  it("on FAIL: fails loudly and aborts before any model runs", () => {
    const { reporter, calls } = spyReporter();
    const decision = reportSerialBudget(
      assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: 30 }),
      reporter,
    );
    expect(decision).toBe("abort");
    expect(calls.setFailed.length).toBe(1);
    expect(calls.setFailed[0]).toContain("1837");
    expect(calls.warning.length).toBe(0);
  });

  // THE anti-vacuity assertion for CONTEXT non-vacuity item 1. Asserting merely that
  // the unchecked path "did not throw" would itself be a gate that cannot fail.
  it("on UNCHECKED: warns EXACTLY ONCE, names the missing input, and continues", () => {
    const { reporter, calls } = spyReporter();
    const decision = reportSerialBudget(
      assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: undefined }),
      reporter,
    );
    expect(decision).toBe("continue");
    expect(calls.warning.length).toBe(1);
    expect(calls.warning[0]).toContain("job_timeout_minutes");
    expect(calls.setFailed.length).toBe(0);
  });

  it("on UNCHECKED: never claims the budget was verified or fine", () => {
    const { reporter, calls } = spyReporter();
    reportSerialBudget(
      assessSerialBudget({ runTimeoutSeconds: 900, jobTimeoutMinutes: undefined }),
      reporter,
    );
    const emitted = [...calls.info, ...calls.warning].join(" ").toLowerCase();
    for (const forbidden of ["verified", "within budget", "budget ok", "fits"]) {
      expect(emitted).not.toContain(forbidden);
    }
  });
});
