// The replay-test gate (ADR-029): every captured history
// must replay against the CANDIDATE interpreter without a nondeterminism error before that build may
// ship. This is the fleet-wide safety net ADR-014 makes both possible and necessary — there is ONE
// interpreter, so one gate protects every workflow, and there is no per-workflow blast radius to
// fall back on. `failBuildOnAnyNondeterminism` is const true: NO waiver path.
//
// Generation-independent (ADR-029 (3)): `Worker.runReplayHistories` replays exported histories
// LOCALLY against this package's own workflow code — no Temporal server, no versioning API needed,
// so the gate runs in plain CI today while versioned dispatch stays config-gated.
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from '@temporalio/worker';
import {historyFromJSON} from '@temporalio/common/lib/proto-utils.js';
import type {
  ReplayGateConfig,
  ReplayGateResult,
  ReplayHistoryFixture,
  ReplayNondeterminismError,
  WorkerBuildId,
} from '@hermes-one/temporal-client';

export const FIXTURE_DIR = fileURLToPath(
  new URL('../test/replay-fixtures/golden', import.meta.url),
);

/** Load committed golden fixtures (`<fixtureId>.history.json`, written by the capture flag on the e2e). */
export function loadFixtures(
  dir: string = FIXTURE_DIR,
): ReplayHistoryFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.history.json'))
    .sort()
    .map(f => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        fixtureId: string;
        workflowType: ReplayHistoryFixture['workflowType'];
        capturedFromBuildId: string;
        tags: string[];
        history: unknown;
      };
      return {...raw, source: 'golden-test' as const};
    });
}

/**
 * Replay every fixture against THIS build's workflow code. A nondeterminism error means the candidate
 * interpreter would break that open execution in production — the exact failure worker versioning
 * exists to prevent, caught in CI instead.
 */
export async function runReplayGate(
  candidateBuildId: WorkerBuildId,
  fixtures: ReplayHistoryFixture[],
  config: ReplayGateConfig,
): Promise<ReplayGateResult> {
  if (fixtures.length < config.minFixtures) {
    return {
      candidateBuildId,
      fixturesRun: 0,
      fixturesPassed: 0,
      nondeterminismErrors: [
        {
          fixtureId: '<gate>',
          message: `only ${fixtures.length} fixtures found; minFixtures=${config.minFixtures}`,
        },
      ],
      passed: false,
    };
  }

  const errors: ReplayNondeterminismError[] = [];
  let passed = 0;
  const results = Worker.runReplayHistories(
    {workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url))},
    (function* () {
      for (const f of fixtures) {
        yield {
          history: historyFromJSON(f.history as never),
          workflowId: f.fixtureId,
        };
      }
    })(),
  );
  for await (const r of results) {
    if (r.error) {
      errors.push({fixtureId: r.workflowId, message: String(r.error)});
    } else {
      passed += 1;
    }
  }

  return {
    candidateBuildId,
    fixturesRun: fixtures.length,
    fixturesPassed: passed,
    nondeterminismErrors: errors,
    passed: errors.length === 0 && passed === fixtures.length,
  };
}
