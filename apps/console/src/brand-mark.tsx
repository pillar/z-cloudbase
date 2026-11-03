import { Boxes } from 'lucide-react';
import { LOGO_URL } from './brand.ts';
import { cn } from '@/lib/utils';

/** The deployment's logo (`--logo-url`), or the default mark on the primary color. */
export function BrandMark({ className }: { className?: string }) {
  if (LOGO_URL) return <img src={LOGO_URL} alt="" className={cn('size-8 shrink-0 rounded-lg object-contain', className)} />;
  return (
    <div className={cn('bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg', className)}>
      <Boxes className="size-4" />
    </div>
  );
}
