// CI entry for the replay gate (ADR-029): replay every committed golden fixture against THIS build's
// interpreter; exit non-zero on ANY nondeterminism or a fixture shortfall. No server needed.
import {deriveBuildId} from '@platform-internal/temporal-client';
import {FIXTURE_DIR, loadFixtures, runReplayGate} from './replay-gate.js';

const fixtures = loadFixtures();
const buildId = process.env.TEMPORAL_WORKER_BUILD_ID ?? deriveBuildId(process.env.GITHUB_SHA ?? 'local', new Date());
const minFixtures = Number(process.env.REPLAY_GATE_MIN_FIXTURES ?? 3);

const result = await runReplayGate(buildId, fixtures, {minFixtures, failBuildOnAnyNondeterminism: true});
console.log(
  `[replay-gate] ${result.passed ? 'PASSED' : 'FAILED'} candidate=${result.candidateBuildId} ` +
    `fixtures=${result.fixturesPassed}/${result.fixturesRun} (dir: ${FIXTURE_DIR})`,
);
for (const e of result.nondeterminismErrors) console.error(`[replay-gate] ✗ ${e.fixtureId}: ${e.message}`);
process.exit(result.passed ? 0 : 1);
