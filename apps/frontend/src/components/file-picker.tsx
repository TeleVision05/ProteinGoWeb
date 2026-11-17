import { useRef } from 'react';
import { cn } from '@/lib/utils';

/** One plain row: "Choose file", or the chosen file's name with a × to clear it. */
export function FilePicker({
  id,
  accept,
  file,
  disabled,
  onChange,
}: {
  id: string;
  accept?: string;
  file: File | null;
  disabled?: boolean;
  onChange: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={cn(
        'flex h-10 w-full min-w-0 items-center overflow-hidden rounded-md border bg-card text-sm',
        disabled ? 'opacity-50' : 'hover:bg-accent',
      )}
    >
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      <label
        htmlFor={id}
        title={file?.name}
        className={cn(
          'min-w-0 flex-1 truncate px-3 leading-10',
          file ? '' : 'text-muted-foreground',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        {file ? file.name : 'Choose file'}
      </label>
      {file ? (
        <button
          type="button"
          aria-label="Remove chosen file"
          className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-lg leading-none text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (input.current) input.current.value = '';
            onChange(null);
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
