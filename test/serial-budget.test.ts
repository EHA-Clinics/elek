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
import { parseJobTimeoutMinutesInput } from "../src/github/context";

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
