export function nextWorkflowFor(workflows, workflowId) {
  const completedIndex = workflows.findIndex((workflow) => workflow.id === workflowId);
  return completedIndex >= 0 ? workflows[completedIndex + 1] || null : null;
}
