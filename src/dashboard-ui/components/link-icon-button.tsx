import { ExternalLink } from 'lucide-react'
import { Button } from './ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'

export function LinkIconButton({ href, label }: { href: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon">
          <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
            <ExternalLink />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-all">{href}</TooltipContent>
    </Tooltip>
  )
}
