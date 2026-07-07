import { Skeleton } from "./skeleton"
import { Card, CardContent } from "./card"


export function TablePageSkeleton({ title = "" }: { title?: string }) {
  return (
    <div className="space-y-6">
      {}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          {title
            ? <h1 className="text-2xl font-bold text-[var(--foreground)]">{title}</h1>
            : <Skeleton className="h-8 w-40" />
          }
        </div>
        <Skeleton className="h-10 w-24" />
      </div>

      {}
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-[300px]" />
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-10 w-32" />
      </div>

      {}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-white">
        {}
        <div className="flex items-center gap-4 border-b border-[var(--border)] px-4 py-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {}
        {Array.from({ length: 5 }).map((_, row) => (
          <div key={row} className="flex items-center gap-4 border-b border-[var(--border)] px-4 py-4 last:border-b-0">
            {Array.from({ length: 6 }).map((_, col) => (
              <Skeleton key={col} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>

      {}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-48" />
      </div>
    </div>
  )
}


export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">工作台</h1>
        <p className="mt-1 text-sm text-[#999999]">欢迎使用凤御美业管理后台</p>
      </div>

      {}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-5 space-y-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-3 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>

      {}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardContent className="p-5 space-y-4">
            <Skeleton className="h-5 w-24" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 space-y-4">
            <Skeleton className="h-5 w-24" />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}


export function FormPageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-8 w-48" />
      </div>
      <Card>
        <CardContent className="p-6 space-y-6">
          <Skeleton className="h-5 w-24" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
          <Skeleton className="h-5 w-24 mt-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
