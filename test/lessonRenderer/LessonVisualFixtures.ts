import { LessonLayout, type LessonScreen } from '../../src/contracts/LessonVideos.js';

export const lessonVisualScreen: LessonScreen = {
  layout: LessonLayout.EXAMPLE,
  title: 'Explain the relationship',
  points: ['A concrete example'],
  narration: 'Watch how the objects change.',
};

export const lessonVisualFixtures = {
  counting: `
import {interpolate} from 'remotion';
export default function Scene({frame, width}) {
  const progress = interpolate(frame, [0, 29], [0, 1], {extrapolateRight: 'clamp'});
  return <svg viewBox="0 0 1176 390">
    {[1,2,3,4,5,6].map((digit,index) => <g key={digit} transform={\`translate(\${100 + index*150}, \${80 + (digit%2===0 ? progress*120 : 0)})\`}>
      <circle r={30} fill={digit%2===0 ? '#e8ad50' : '#e9efdf'} />
      <text y={8} textAnchor="middle" fontSize={24}>{digit}</text>
    </g>)}
    <text x={width/2} y={340} textAnchor="middle" fontSize={28}>3 choices: 2, 4, 6</text>
  </svg>;
}`,
  philosophy: `
export default function Scene({frame}) {
  return <svg viewBox="0 0 1176 390">
    <text x={588} y={45} textAnchor="middle" fontSize={28}>Is lying ever justified?</text>
    <line x1={588} y1={75} x2={290} y2={160} stroke="#17372f" strokeWidth={3}/>
    <line x1={588} y1={75} x2={880} y2={160} stroke="#17372f" strokeWidth={3}/>
    <g opacity={Math.min(1,frame/20)}>
      <text x={290} y={200} textAnchor="middle" fontSize={24}>Consider the duty</text>
      <text x={880} y={200} textAnchor="middle" fontSize={24}>Consider the consequences</text>
    </g>
  </svg>;
}`,
  scratch: `
export default function Scene({frame}) {
  const iteration = Math.min(10,Math.floor(frame/3));
  return <svg viewBox="0 0 1176 390">
    <rect x={80} y={100} width={260} height={90} rx={12} fill="#e8ad50"/>
    <text x={100} y={145} fontSize={24}>repeat 10: move 10 steps</text>
    <circle cx={500+iteration*35} cy={150} r={28} fill="#17372f"/>
    <text x={500} y={280} fontSize={24}>Iteration: {iteration}</text>
  </svg>;
}`,
} as const;
