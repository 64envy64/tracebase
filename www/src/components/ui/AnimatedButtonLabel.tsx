type AnimatedButtonLabelProps = {
  label: string;
  showArrow?: boolean;
};

export function AnimatedButtonLabel({
  label,
  showArrow = true,
}: AnimatedButtonLabelProps) {
  return (
    <span className="inline-flex items-center justify-center">
      <span className="transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-x-[1px] group-focus-visible:-translate-x-[1px]">
        {label}
      </span>
      {showArrow ? (
        <span className="ml-0 inline-flex w-0 translate-x-[-6px] overflow-hidden opacity-0 transition-[width,margin,transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:ml-2 group-hover:w-4 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:ml-2 group-focus-visible:w-4 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            className="h-4 w-4 shrink-0"
          >
            <path
              d="M3.5 8h8.25M8.75 4.75 12.25 8l-3.5 3.25"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
    </span>
  );
}
