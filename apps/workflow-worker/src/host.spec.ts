import {describe, expect, it} from 'vitest';
import {buildBundle, buildTriageBundle} from './bundle.js';
import {selectHostWorkflow} from './host.js';

describe('selectHostWorkflow', () => {
  it('selects the deterministic host for a plan without agent nodes', () => {
    expect(selectHostWorkflow(buildBundle({}).workflowPlan)).toBe(
      'runCompiledWorkflow',
    );
  });

  it('selects the agent host for a plan with an agent node', () => {
    expect(selectHostWorkflow(buildTriageBundle({}).workflowPlan)).toBe(
      'runAgentWorkflow',
    );
  });

  it('selects the deterministic host for an empty graph', () => {
    expect(selectHostWorkflow({graph: {}})).toBe('runCompiledWorkflow');
  });
});
