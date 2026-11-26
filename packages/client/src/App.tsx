import { useEffect, useState } from "react";
import { Home } from "./Home.tsx";
import { OnlineRoom } from "./online/OnlineRoom.tsx";
import { PracticeGame } from "./PracticeGame.tsx";
import { SoundSampler } from "./SoundSampler.tsx";

/** Tiny router: "/", "/practice", "/sounds", "/room/CODE". */
function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    if (to !== location.pathname) history.pushState(null, "", to);
    setPath(to);
    scrollTo(0, 0);
  };
  return [path, navigate];
}

export function App() {
  const [path, navigate] = usePath();
  const goHome = () => navigate("/");

  const room = path.match(/^\/room\/([A-Za-z0-9]+)\/?$/);
  if (room) return <OnlineRoom key={room[1]!.toUpperCase()} code={room[1]!.toUpperCase()} onHome={goHome} />;
  if (path === "/practice") return <PracticeGame onHome={goHome} />;
  if (path === "/sounds") return <SoundSampler onHome={goHome} />;
  return <Home onNavigate={navigate} />;
}
