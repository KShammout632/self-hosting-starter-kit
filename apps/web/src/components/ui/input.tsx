import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Input = ({ className, ...props }: ComponentProps<'input'>) => (
  <input
    className={cn(
      'h-10 w-full rounded-md border bg-card px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary',
      className,
    )}
    {...props}
  />
);
