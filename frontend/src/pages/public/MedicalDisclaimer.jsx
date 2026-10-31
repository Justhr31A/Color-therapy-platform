/**
 * Careful, consistent wording used everywhere the public site could be read as a medical claim. The platform
 * must never appear to diagnose, treat, cure, prevent, or guarantee any outcome — this is the one place that
 * wording lives, so it can never drift between pages.
 */
export default function MedicalDisclaimer() {
  return (
    <div className="pv-disclaimer" role="note">
      <strong>Important:</strong> These protocols are informational only. They do not diagnose, treat, cure, or
      prevent any condition, and no outcome is guaranteed. They are not a substitute for professional medical
      advice, diagnosis, or treatment — always consult a qualified healthcare provider with any questions about
      a medical condition.
    </div>
  );
}
