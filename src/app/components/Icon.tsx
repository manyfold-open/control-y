/** 16px stroke icons, currentColor, no dependency. */

const paths: Record<string, string> = {
  reviews: 'M4 3h9l3 3v11H4z M13 3v3h3',
  people: 'M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M2.5 16v-1a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4v1 M13 7.5a2 2 0 1 0 0-4 M14 11.2a3.5 3.5 0 0 1 3.5 3.5V16',
  memory: 'M10 3.5c-1.5-1.2-4-1-5.2.6-1 1.3-.8 3 .2 4.2-1.2 1-1.5 2.8-.6 4.1 1 1.5 3.2 1.8 4.6.7 M10 3.5c1.5-1.2 4-1 5.2.6 1 1.3.8 3-.2 4.2 1.2 1 1.5 2.8.6 4.1-1 1.5-3.2 1.8-4.6.7 M10 3.5V16',
  agents: 'M10 2.5 17 6.5v7L10 17.5 3 13.5v-7z M10 2.5v15 M3 6.5l7 4 7-4',
  plug: 'M7 3v4 M13 3v4 M5 7h10v3a5 5 0 0 1-10 0z M10 15v3',
  plus: 'M10 4.5v11 M4.5 10h11',
  copy: 'M7 7h8v9H7z M5 13H4V4h9v1',
  check: 'M4.5 10.5 8 14l7.5-7.5',
  x: 'M5 5l10 10 M15 5 5 15',
  arrow: 'M4 10h12 M11 5l5 5-5 5',
  search: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12z M13.5 13.5 17 17',
  inbox: 'M3 11h4l1 2h4l1-2h4 M3 11 5 4h10l2 7v5H3z',
  filter: 'M3 5h14 M6 10h8 M8.5 15h3',
  dot: 'M10 10h.01',
  /* Disclosure. Rotated by CSS when its section is open, so one glyph carries
     both states. */
  chevron: 'M5.5 8 10 12.5 14.5 8',
  edit: 'M13.7 3.8a1.7 1.7 0 0 1 2.4 2.4l-9 9-3.3.9.9-3.3z M12.5 5l2.5 2.5',
  /* The whole queue at once, for stepping out of it. */
  list: 'M4 5.5h12 M4 10h12 M4 14.5h12',
  /* A target, for whether an entry is aimed at the review being run. */
  scope: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  /* Replaces the ⚠ character, which the platform renders as colour emoji. */
  alert: 'M10 3.2 2.9 16h14.2z M10 8v3.4 M10 13.8h.01',
};

export default function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  const d = paths[name] ?? paths.dot;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}
