'use client';

/**
 * The last-resort boundary. It replaces the root layout, so it must render its
 * own html and body and cannot rely on any application styling.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0d0f12',
          color: '#e8eaed',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem', maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.125rem', margin: 0 }}>Atrium Studio could not start</h1>
          <p style={{ fontSize: '0.8125rem', color: '#97a0aa', lineHeight: 1.6 }}>
            An unrecoverable error occurred while loading the application. Your saved projects are
            unaffected.
          </p>
          {error.digest ? (
            <p style={{ fontSize: '0.6875rem', color: '#667079' }}>Reference: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              borderRadius: '0.25rem',
              border: '1px solid #333941',
              background: '#5b9dd9',
              color: '#0a1219',
              fontSize: '0.8125rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
