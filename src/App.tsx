/**
 * Starting point. Replace all of this.
 *
 * There is deliberately no routing, styling or state management here —
 * those choices are yours to make and are part of what is being assessed.
 */

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.6 }}>
      <h1>FieldOps Console</h1>
      <p>
        The mock API is running. Open the network tab and try{' '}
        <code>fetch(&apos;/api/summary&apos;).then((r) =&gt; r.json()).then(console.log)</code> in the
        console.
      </p>
      <p>
        Read <code>ASSIGNMENT.md</code> for what to build and <code>src/mock/README.md</code> for what
        the mock layer gives you.
      </p>
    </main>
  );
}
