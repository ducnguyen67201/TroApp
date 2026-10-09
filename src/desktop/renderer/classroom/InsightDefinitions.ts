import type { InsightMapping, InsightPlan } from '#contracts/ClassroomInsights.js';

export function selectLatestMappings(mappings: InsightMapping[]): InsightMapping[] {
  const latest = new Map<string, InsightMapping>();
  for (const mapping of mappings) {
    if ((latest.get(mapping.id)?.version ?? 0) < mapping.version) {
      latest.set(mapping.id, mapping);
    }
  }
  return [...latest.values()];
}

export function selectLatestPlans(plans: InsightPlan[]): InsightPlan[] {
  const latest = new Map<string, InsightPlan>();
  for (const plan of plans) {
    if ((latest.get(plan.id)?.version ?? 0) < plan.version) {
      latest.set(plan.id, plan);
    }
  }
  return [...latest.values()];
}
