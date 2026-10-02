export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <main style={{ maxWidth: 500, margin: '12vh auto', fontFamily: 'Arial,sans-serif', padding: 24 }}>
    <h1>VYRO</h1><hr/><h2>Email preferences</h2>
    <p>Stop receiving commercial emails from VYRO.</p>
    {token ? <form action="/api/unsubscribe" method="POST"><input type="hidden" name="token" value={token}/><button type="submit">Unsubscribe</button></form> : <p>This unsubscribe link is incomplete.</p>}
  </main>;
}
