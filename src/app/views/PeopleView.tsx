import { PEOPLE, ISSUES, initials } from '../mock/data';
import Icon from '../components/Icon';

export default function PeopleView() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">People</h1>
          <p className="page-sub">
            Configured once. Each review picks who is involved and gives them a title for that review only — editing a
            title never touches this directory.
          </p>
        </div>
        <button className="button primary" type="button">
          <Icon name="plus" /> Add people
        </button>
      </header>

      <div className="table-card">
        <div className="table-head people">
          <span>Person</span>
          <span>Directory role</span>
          <span>Title on Q1 2026</span>
          <span>Open</span>
        </div>

        {PEOPLE.map((p) => {
          const count = ISSUES.filter((i) => i.assigneeId === p.id && i.status === 'open').length;
          return (
            <div key={p.id} className="people-row">
              <span className="person">
                <span className={p.isSelf ? 'avatar self' : 'avatar'}>{initials(p.name)}</span>
                <span className="person-name">
                  <span className="person-line">
                    {p.name}
                    {p.isSelf && <span className="chip mint">you</span>}
                  </span>
                  <span className="person-org">{p.org}</span>
                </span>
              </span>
              <span className="people-cell">{p.role}</span>
              <span className="people-cell emphasis">{p.reviewTitle}</span>
              <span className="people-cell tnum">{count > 0 ? count : '—'}</span>
            </div>
          );
        })}
      </div>

      <p className="page-note">
        The consolidator assigns from the <b>review title</b>, not the directory role — “who can answer this” is a fact
        about this period’s work, not about the person in general.
      </p>
    </div>
  );
}
