import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, roomRequest } from "./room-api";
import "./web-login.css";

export interface AuthState {
  user: { name: string; email: string } | null;
  localPlay: boolean;
}

const localPlayers = [
  { name: "Yannick", email: "yannick@arcane-fold.test" },
  { name: "Jef", email: "jef@arcane-fold.test" },
];

export default function WebLogin({ auth, loadError, onRetry, onSignedIn }: {
  auth?: AuthState;
  loadError: string;
  onRetry: () => void;
  onSignedIn: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function signIn(path: string, payload: Record<string, string>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await roomRequest<AuthState>(path, payload);
      onSignedIn();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void signIn("/login", { email: String(data.get("email")).trim(), password: String(data.get("password")) });
  }

  return (
    <main className="web-login">
      <div className="login-spread">
        <div className="login-cover">
          <div className="login-brand"><img src="/arcane-fold.png" alt="" />Arcane Fold</div>
          <div className="login-deck-art" aria-hidden="true">
            <div className="login-card login-card-rear" />
            <div className="login-card login-card-front"><span className="login-card-seal"><img src="/arcane-fold.png" alt="" /></span></div>
          </div>
        </div>
        <section className="login-panel" aria-labelledby="login-heading">
          <h1 id="login-heading">Sign in</h1>
          {auth ? <>
            <form onSubmit={submit} className="login-form">
              <label htmlFor="league-email">Email address</label>
              <Input id="league-email" name="email" type="email" autoComplete="username" autoCapitalize="none"
                spellCheck={false} placeholder="name@arcane-fold.test" required disabled={pending} />
              <label htmlFor="league-password">Password</label>
              <div className="login-password">
                <Input id="league-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password"
                  required disabled={pending} />
                <button type="button" onClick={() => setVisible(!visible)}
                  aria-label={visible ? "Hide password" : "Show password"} title={visible ? "Hide password" : "Show password"}>
                  {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {error && <p role="alert" className="login-error">{error}</p>}
              <Button type="submit" disabled={pending} className="login-submit">Sign in <ArrowRight size={16} /></Button>
            </form>
            {auth.localPlay && <section aria-labelledby="local-play-heading" className="local-login">
              <h2 id="local-play-heading">Local play</h2>
              <p>Choose a player to continue without a password.</p>
              <div className="local-players">{localPlayers.map((player) => (
                <button key={player.email} type="button" disabled={pending}
                  onClick={() => void signIn("/local-login", { email: player.email })}>
                  <strong>{player.name}</strong>
                  <ArrowRight size={15} aria-hidden />
                </button>
              ))}</div>
            </section>}
          </> : loadError ? <div className="login-failure">
            <p className="login-error" role="alert">{loadError}</p><Button variant="outline" onClick={onRetry}>Try again</Button>
          </div> : <p className="login-loading" role="status">Checking your session…</p>}
        </section>
      </div>
    </main>
  );
}
