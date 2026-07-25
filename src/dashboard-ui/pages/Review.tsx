import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx'
import type { GroupedQuestion, QuestionCluster } from '../../dashboard/api-types.ts'

function FeedbackForm({ question, answer }: { question: string; answer: string }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const feedback = useMutation({
    mutationFn: (verdict: 'correct' | 'wrong') => api.submitFeedback({ question, answer, verdict, note: note || undefined }),
    onSuccess: () => {
      toast.success('Feedback saved')
      queryClient.invalidateQueries({ queryKey: ['unreviewed'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  return (
    <div className="flex flex-wrap items-center gap-2 border-t py-2 first:border-t-0">
      <p className="flex-1 text-sm">{answer}</p>
      <Button size="sm" variant="outline" disabled={feedback.isPending} onClick={() => feedback.mutate('correct')}>
        Correct
      </Button>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="corrected answer (if wrong)"
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      />
      <Button size="sm" variant="destructive" disabled={feedback.isPending} onClick={() => feedback.mutate('wrong')}>
        Wrong
      </Button>
    </div>
  )
}

function UnreviewedCard({ group }: { group: GroupedQuestion }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{group.question}</CardTitle>
      </CardHeader>
      <CardContent>
        {group.variants.map((v) => (
          <FeedbackForm key={v.answer} question={group.question} answer={v.answer} />
        ))}
      </CardContent>
    </Card>
  )
}

function ClusterCard({ cluster, groups }: { cluster: QuestionCluster; groups: GroupedQuestion[] }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const members = cluster.memberQuestions
    .map((q) => groups.find((g) => g.question === q))
    .filter((g): g is GroupedQuestion => g !== undefined)
  const pairs = members.flatMap((g) => g.variants.map((v) => ({ question: g.question, answer: v.answer })))

  const feedback = useMutation({
    mutationFn: (verdict: 'correct' | 'wrong') => api.submitClusterFeedback({ members: pairs, verdict, note: note || undefined }),
    onSuccess: () => {
      toast.success('Feedback saved')
      queryClient.invalidateQueries({ queryKey: ['unreviewed'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{cluster.canonicalQuestion}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {members.map((g) => (
          <div key={g.question} className="text-sm text-muted-foreground">
            <strong className="text-foreground">{g.question}</strong>
            {g.variants.map((v) => (
              <div key={v.answer}>
                &rarr; {v.answer} ({v.jobs.length} application(s))
              </div>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button size="sm" variant="outline" disabled={feedback.isPending} onClick={() => feedback.mutate('correct')}>
            All correct
          </Button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="corrected answer to use for all of these (if wrong)"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          />
          <Button size="sm" variant="destructive" disabled={feedback.isPending} onClick={() => feedback.mutate('wrong')}>
            Wrong
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function ReviewPage() {
  const { data: groups, isLoading, error } = useQuery({ queryKey: ['unreviewed'], queryFn: api.getUnreviewed })
  const [clusters, setClusters] = useState<QuestionCluster[] | null>(null)

  const generate = useMutation({
    mutationFn: api.generateClusters,
    onSuccess: (res) => {
      if (res.error) {
        toast.error(`Failed to generate unique questions: ${res.error}`)
        return
      }
      setClusters(res.clusters ?? [])
      toast.success('Clusters generated')
    },
    onError: (err) => toast.error((err as Error).message),
  })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (error) return <p className="text-destructive">Failed to load review data: {(error as Error).message}</p>

  return (
    <div className="space-y-6">
      {clusters && (
        <div>
          <h1 className="mb-4 text-2xl font-semibold">Clustered questions</h1>
          <div className="space-y-4">
            {clusters.map((c) => (
              <ClusterCard key={c.canonicalQuestion} cluster={c} groups={groups ?? []} />
            ))}
          </div>
          <hr className="my-6" />
        </div>
      )}

      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Unreviewed</h1>
          <Button disabled={generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? 'Generating…' : 'Generate unique questions'}
          </Button>
        </div>
        {!groups || groups.length === 0 ? (
          <p className="text-muted-foreground">No unreviewed answers.</p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <UnreviewedCard key={g.question} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
