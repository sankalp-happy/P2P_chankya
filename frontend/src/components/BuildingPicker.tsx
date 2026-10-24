import { BUILDING_SPRITE, SHORT_NAME } from '../lib/constants';
import { Sprite } from './ui';

export function BuildingPicker({ ids, value, onChange }: { ids: string[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Building">
      {ids.map((id) => (
        <button
          key={id}
          role="radio"
          aria-checked={value === id}
          data-on={value === id}
          onClick={() => onChange(id)}
          title={SHORT_NAME[id]}
          className="chip-btn h-9 gap-2 pr-3 pl-1.5"
        >
          <Sprite name={BUILDING_SPRITE[id]} size={22} />
          <span>{SHORT_NAME[id]}</span>
        </button>
      ))}
    </div>
  );
}
