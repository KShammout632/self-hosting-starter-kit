import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('rounded-xl border bg-card p-5 shadow-sm', className)} {...props} />
);
