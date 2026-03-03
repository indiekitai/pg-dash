import { gradeColors, gradeBg } from "../types";

export function GradeCircle({ grade, score }: { grade: string; score: number }) {
  return (
    <div className={`flex flex-col items-center justify-center w-40 h-40 rounded-full border-4 ${gradeColors[grade]} ${gradeBg[grade]}`}>
      <span className="text-5xl font-black">{grade}</span>
      <span className="text-lg font-semibold">{score}/100</span>
    </div>
  );
}
