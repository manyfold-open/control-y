/**
 * The app's own dropdown.
 *
 * A native <select> paints its list with the operating system: the OS font, the OS
 * highlight colour, the OS radius. It is the one control on these pages that ignores
 * the design system, and on a screen this quiet it reads as somebody else's software
 * dropped into the middle of the product. This is the ARIA combobox pattern instead,
 * built from the vocabulary already here: a `.button`-shaped trigger, a list painted
 * like `.table-card`, rows that behave like `.rail-item`, and a `check` on the one
 * that is chosen.
 *
 * The list is portaled to <body> and positioned fixed. Every place this is used sits
 * inside a scrolling box (`.dialog-form`, `.drawer-body`), which would clip a popup
 * positioned against the trigger.
 *
 * Keyboard behaviour matches a native select, because anything less would be a worse
 * control than the one it replaces: arrows and Home/End move, typing jumps, Enter and
 * Space commit, Escape closes and hands focus back. Focus stays on the trigger and
 * the active row is named by aria-activedescendant, so a screen reader follows along
 * without the list stealing the tab order.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

export interface SelectOption {
  value: string;
  label: string;
  /** A quieter second line, for what the label itself cannot carry. */
  note?: string;
  /** Listed, but not choosable. Skipped by the keyboard, as a native select does. */
  disabled?: boolean;
}

interface Placement {
  top: number;
  left: number;
  width: number;
  /** Set when there is more room above the trigger than below it. */
  up: boolean;
}

/** How long a run of typed characters counts as one search, in ms. */
const TYPEAHEAD_WINDOW = 900;

export default function Select({
  value,
  options,
  onChange,
  placeholder = 'Choose',
  disabled = false,
  className,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown on the trigger when `value` matches nothing in `options`. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);

  const selected = options.find((option) => option.value === value) ?? null;

  const firstUsable = () => options.findIndex((option) => !option.disabled);
  const lastUsable = () => {
    for (let i = options.length - 1; i >= 0; i -= 1) if (!options[i].disabled) return i;
    return 0;
  };
  const step = (from: number, delta: number) => {
    for (let i = from + delta; i >= 0 && i < options.length; i += delta) {
      if (!options[i].disabled) return i;
    }
    return from;
  };

  const measure = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom;
    const up = below < 260 && box.top > below;
    setPlace({ top: up ? box.top - 4 : box.bottom + 4, left: box.left, width: box.width, up });
  }, []);

  // Fixed positioning is only right for as long as nothing moves, so re-measure on
  // anything that could move it. Scroll is captured, to catch scrolling ancestors.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const again = () => measure();
    window.addEventListener('scroll', again, true);
    window.addEventListener('resize', again);
    return () => {
      window.removeEventListener('scroll', again, true);
      window.removeEventListener('resize', again);
    };
  }, [open, measure]);

  // A press outside closes without taking focus off whatever was pressed.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || list.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the active row in view as the keyboard walks the list.
  useEffect(() => {
    if (!open) return;
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const show = () => {
    const start = options.findIndex((option) => option.value === value);
    setActive(start >= 0 && !options[start].disabled ? start : Math.max(firstUsable(), 0));
    typed.current = { text: '', at: 0 };
    setOpen(true);
  };

  const hide = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    hide();
  };

  const jumpTo = (char: string) => {
    const now = Date.now();
    const text = now - typed.current.at > TYPEAHEAD_WINDOW ? char : typed.current.text + char;
    typed.current = { text, at: now };
    const needle = text.toLowerCase();
    const found = options.findIndex(
      (option) => !option.disabled && option.label.toLowerCase().startsWith(needle),
    );
    if (found >= 0) setActive(found);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        show();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current) => step(current, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => step(current, -1));
        return;
      case 'Home':
        event.preventDefault();
        setActive(Math.max(firstUsable(), 0));
        return;
      case 'End':
        event.preventDefault();
        setActive(lastUsable());
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(active);
        return;
      case 'Escape':
        event.preventDefault();
        hide();
        return;
      case 'Tab':
        setOpen(false);
        return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          jumpTo(event.key);
        }
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className ? `select-trigger ${className}` : 'select-trigger'}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? 'select-value' : 'select-value empty'}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron" size={14} />
      </button>

      {open &&
        place &&
        createPortal(
          <div
            ref={list}
            id={listId}
            role="listbox"
            className="select-list"
            style={{
              top: place.top,
              left: place.left,
              minWidth: place.width,
              transform: place.up ? 'translateY(-100%)' : undefined,
            }}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={[
                  'select-option',
                  index === active ? 'active' : '',
                  option.disabled ? 'off' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseEnter={() => !option.disabled && setActive(index)}
                // Keeps focus on the trigger, so the combobox never loses its keyboard.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(index)}
              >
                <span className="select-option-text">
                  {option.label}
                  {option.note && <small>{option.note}</small>}
                </span>
                {option.value === value && <Icon name="check" size={14} />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
