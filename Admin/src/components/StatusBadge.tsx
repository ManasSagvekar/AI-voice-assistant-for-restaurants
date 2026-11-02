type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange} className={`switch${on ? ' on' : ''}`}>
      <span />
    </button>
  );
}
