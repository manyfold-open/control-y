import type { ConnectedAgent } from '../../shared/types';

const isExpired = (agent: ConnectedAgent): boolean =>
  Boolean(agent.expiresAt && Date.parse(agent.expiresAt) <= Date.now());

export default function AgentPicker(props: {
  agents: ConnectedAgent[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}) {
  return (
    <select
      className="agent-picker"
      aria-label="Agent"
      value={props.selectedId ?? ''}
      onChange={(event) => props.onSelect(event.target.value)}
    >
      {props.agents.map((agent) => (
        <option key={agent.agentId} value={agent.agentId} disabled={isExpired(agent)}>
          {agent.name}
          {isExpired(agent) ? ' (authorization expired)' : agent.verified ? '' : ' (unverified)'}
        </option>
      ))}
    </select>
  );
}
