/**
 * The count of turns — the one number the fund manager said he actually cares
 * about. Earlier passes recede; the current count is the hero, and turns mint
 * when a review reached zero.
 */

export default function Convergence({ passes, running = false }: { passes: number[]; running?: boolean }) {
  if (passes.length === 0) {
    return (
      <span className="convergence">
        <span className="cv-unit">{running ? 'first pass running' : 'not run yet'}</span>
      </span>
    );
  }

  const last = passes[passes.length - 1];
  const prior = passes.slice(0, -1);
  const landed = last === 0;

  return (
    <span className="convergence" aria-label={`Passes: ${passes.join(', then ')}`}>
      <span className="cv-figures">
        {prior.map((count, index) => (
          <span key={index} className="cv-prior">
            {count}
            <span className="cv-sep" aria-hidden>
              →
            </span>
          </span>
        ))}
        <b className={landed ? 'cv-last landed' : 'cv-last'}>{last}</b>
      </span>
      <span className="cv-unit">{running ? 'open · pass running' : landed ? 'closed' : 'open'}</span>
    </span>
  );
}
