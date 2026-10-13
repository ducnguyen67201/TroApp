import type { LessonVisualBrief } from '#contracts/LessonVisuals.js';

const revealRecipe = `For sequential explanation, reveal SVG groups at saved frame thresholds:
const progress = Math.min(1, Math.max(0, (frame - 20) / 15));
return <svg viewBox="0 0 1176 390"><g opacity={progress}><rect x={60} y={80} width={360} height={160} rx={18} fill="#edf2e6"/><text x={90} y={150} fill="#17372f" fontSize={30}>First idea</text></g></svg>;
Use the scene's actual teaching content, not these example words.`;

const movementRecipe = `For movement or grouping, derive positions from frame, never timers:
const progress = Math.min(1, Math.max(0, (frame - 30) / 40));
const x = 160 + (520 - 160) * progress;
return <svg viewBox="0 0 1176 390"><circle cx={x} cy={160} r={36} fill="#f4bf64"/><text x={x} y={170} textAnchor="middle" fill="#17372f" fontSize={28}>2</text></svg>;
Apply the technique to relevant objects, preserve identities and label what the movement explains.`;

const branchRecipe = `For arguments, decisions or processes, reveal labelled SVG nodes and connecting paths:
const visible = frame >= 30;
return <svg viewBox="0 0 1176 390"><rect x={420} y={30} width={330} height={70} rx={14} fill="#edf2e6"/><text x={585} y={75} textAnchor="middle" fill="#17372f" fontSize={24}>Question</text><g opacity={visible ? 1 : 0}><path d="M585 100 L260 210 M585 100 L910 210" stroke="#17372f" strokeWidth={3} fill="none"/><text x={260} y={245} textAnchor="middle" fill="#17372f" fontSize={24}>One explanation</text><text x={910} y={245} textAnchor="middle" fill="#17372f" fontSize={24}>Another explanation</text></g></svg>;
Replace example labels with source-grounded claims. Do not imply a theory or conclusion absent from the lesson.`;

/** A compact relevant example replaces a classifier request and a whole example catalogue. */
export function selectLessonVisualRecipes(brief: LessonVisualBrief): string[] {
  const description = `${brief.objective} ${brief.description}`.toLowerCase();
  if (
    /argument|theor|premise|conclusion|dilemma|branch|triết|lập luận|so sánh/u.test(description)
  ) {
    return [revealRecipe, branchRecipe];
  }
  if (
    /move|group|count|loop|sprite|scratch|number|digit|nhóm|đếm|lặp|di chuyển/u.test(description)
  ) {
    return [revealRecipe, movementRecipe];
  }
  return [revealRecipe];
}
