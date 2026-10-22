// The card every authentication page uses (P3-0; design reference §5): a clear heading, one line of explanation, the form, then the
// helper links. The logo above it comes from app/(auth)/layout.tsx.
export function AuthCard({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <>
      <section aria-labelledby="auth-title" className="rounded-xl border bg-card px-5 py-6 text-card-foreground shadow-[var(--shadow-md)] sm:px-8 sm:py-8">
        <div className="mb-6 space-y-1.5 text-center">
          <h1 id="auth-title" className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </section>
      {footer && <div className="mt-4 flex flex-col items-center gap-2 text-sm">{footer}</div>}
    </>
  )
}
