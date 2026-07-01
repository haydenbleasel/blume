import "./index.css";
import { Composition } from "remotion";

import { MyComposition } from "./composition";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="MyComp"
      component={MyComposition}
      durationInFrames={60}
      fps={30}
      width={1280}
      height={720}
    />
  </>
);
