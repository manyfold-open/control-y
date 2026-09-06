/**
 * The shape of a page that has not arrived.
 *
 * Every screen in this product used to open on the word "Loading…" centred in
 * forty pixels of nothing, and then jump to a full table. The jump is the
 * problem: the reader's eye has already settled somewhere before the content
 * lands under it. These placeholders occupy the same grid the real rows will,
 * so nothing moves when the fetch returns — only the greys turn into words.
 *
 * They are deliberately dumb. No count from the server, no remembered last
 * height: a skeleton that guesses how many rows are coming and guesses wrong is
 * a worse jump than no skeleton at all. A fixed handful reads as "a table is
 * coming", which is the entire claim being made.
 *
 * The text is still there for a screen reader, which gains nothing from grey
 * boxes and wants the sentence.
 */

const bars = (count: number) => Array.from({ length: count }, (_, index) => index);

/** A single grey bar. `width` is a percentage of its cell. */
function Bar({ width = 100 }: { width?: number }) {
  return <span className="sk-bar" style={{ width: `${width}%` }} />;
}

/* The widths below are hand-varied rather than random. A random width re-rolls
   on every render — while a poll is running that is a placeholder that fidgets. */
const ROW_WIDTHS = [72, 54, 84, 61, 78, 49];

export default function Skeleton({
  shape,
  rows = 5,
}: {
  shape: 'table' | 'people' | 'stack' | 'review' | 'panel';
  rows?: number;
}) {
  return (
    /* The shape reaches the wrapper because the review one has to: `.review` is
       `height: 100%`, and a plain div between it and `main` would leave that
       resolving against nothing. */
    <div className={`skeleton skeleton-${shape}`} role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {shape === 'review' ? <ReviewShape /> : <PageShape shape={shape} rows={rows} />}
    </div>
  );
}

function PageShape({ shape, rows }: { shape: 'table' | 'people' | 'stack' | 'panel'; rows: number }) {
  if (shape === 'panel') {
    return (
      <div className="table-card sk-panel" aria-hidden>
        {bars(3).map((index) => (
          <div key={index} className="sk-panel-row">
            <Bar width={index === 0 ? 34 : 26} />
            <Bar width={ROW_WIDTHS[index]} />
          </div>
        ))}
      </div>
    );
  }

  if (shape === 'stack') {
    return (
      <div className="table-card" aria-hidden>
        {bars(rows).map((index) => (
          <div key={index} className="sk-stack-row">
            <Bar width={ROW_WIDTHS[index % ROW_WIDTHS.length] * 0.5} />
            <Bar width={ROW_WIDTHS[(index + 2) % ROW_WIDTHS.length]} />
          </div>
        ))}
      </div>
    );
  }

  // The two grid tables share their column template with the real thing, so the
  // header cells and every row land exactly where they will land for real.
  const head = shape === 'people' ? 'table-head people' : 'table-head';
  const row = shape === 'people' ? 'people-row' : 'review-row';
  return (
    <div className="table-card" aria-hidden>
      <div className={`${head} sk-head`}>
        <Bar width={30} />
        <Bar width={54} />
        <Bar width={38} />
        <Bar width={46} />
      </div>
      {bars(rows).map((index) => (
        <div key={index} className={`${row} sk-row`}>
          <Bar width={ROW_WIDTHS[index % ROW_WIDTHS.length]} />
          <Bar width={64} />
          <Bar width={ROW_WIDTHS[(index + 3) % ROW_WIDTHS.length]} />
          <Bar width={52} />
        </div>
      ))}
    </div>
  );
}

/**
 * The review's own furniture, in its order: the bar, the queue strip under it,
 * and the one issue on the stage. The strip is the part worth drawing — it is
 * the only thing on this screen whose height the reader's eye uses to find the
 * work, so an empty gap there and then a sudden row of ticks is the jump this
 * whole component exists to avoid.
 */
function ReviewShape() {
  return (
    <div className="review sk-review" aria-hidden>
      <header className="review-head">
        <Bar width={38} />
        <Bar width={22} />
      </header>
      <div className="queue-strip">
        <div className="queue-marks">
          {bars(9).map((index) => (
            <span key={index} className="sk-bar sk-mark" />
          ))}
        </div>
      </div>
      <div className="review-stage">
        <div className="sk-detail">
          <Bar width={58} />
          <Bar width={92} />
          <Bar width={86} />
          <Bar width={44} />
        </div>
      </div>
    </div>
  );
}
