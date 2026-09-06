import type { ConnectedAgent } from '../../shared/types';
import Select from './Select';

const isExpired = (agent: ConnectedAgent): boolean =>
  Boolean(agent.expiresAt && Date.parse(agent.expiresAt) <= Date.now());

export default function AgentPicker(props: {
  agents: ConnectedAgent[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}) {
  return (
    <Select
      className="agent-picker"
      ariaLabel="Agent"
      value={props.selectedId ?? ''}
      placeholder="Pick an agent"
      onChange={props.onSelect}
      options={props.agents.map((agent) => ({
        value: agent.agentId,
        label: agent.name,
        note: isExpired(agent) ? 'authorization expired' : agent.verified ? undefined : 'unverified',
        disabled: isExpired(agent),
      }))}
    />
  );
}
