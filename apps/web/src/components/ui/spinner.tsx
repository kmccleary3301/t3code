import { cn } from "~/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-label="Loading"
      className={cn("relative inline-flex items-center justify-center shrink-0", className)}
      role="status"
      {...props}
    >
      <img
        src="/mascot/kyle-mascot-64.png"
        alt="Loading"
        className="size-full rounded-full object-cover select-none motion-safe:animate-spin"
        draggable={false}
      />
    </span>
  );
}

export { Spinner };
