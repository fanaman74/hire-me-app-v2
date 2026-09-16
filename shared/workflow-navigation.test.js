import assert from 'node:assert/strict';
import test from 'node:test';
import { nextWorkflowFor } from './workflow-navigation.js';

const workflows = [
  { id: 'setup', title: 'Setup profile' },
  { id: 'search', title: 'Find matching jobs' },
  { id: 'export', title: 'Export resume' },
];

test('returns the workflow immediately after the completed step', () => {
  assert.equal(nextWorkflowFor(workflows, 'setup'), workflows[1]);
  assert.equal(nextWorkflowFor(workflows, 'search'), workflows[2]);
});

test('returns null after the final or an unknown workflow', () => {
  assert.equal(nextWorkflowFor(workflows, 'export'), null);
  assert.equal(nextWorkflowFor(workflows, 'missing'), null);
});
