import { useParams } from 'react-router-dom';
import ProtocolStudio from '../builder/ProtocolStudio';

/** Route wrapper for /builder/:id. `key` remounts the Studio cleanly when navigating to another protocol (e.g. after Duplicate). */
export default function ProtocolStudioPage() {
  const { id } = useParams();
  return <ProtocolStudio key={id} protocolId={id} />;
}
