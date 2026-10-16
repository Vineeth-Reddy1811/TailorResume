import { useEffect, useMemo, useState } from "react";
import type { ResumeProfileView } from "../../shared/api";

export default function ResumeProfilePanel({
  profile,
  loading,
  saving,
  error,
  onSave,
}: {
  profile: ResumeProfileView | null;
  loading: boolean;
  saving: boolean;
  error?: string;
  onSave: (skills: Array<{ canonical: string; confirmed: boolean }>) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [newSkill, setNewSkill] = useState("");
  const [customSkills, setCustomSkills] = useState<string[]>([]);
  useEffect(() => {
    setConfirmed(Object.fromEntries((profile?.verifiedSkills ?? []).map((skill) => [skill.canonical, skill.userConfirmed === true && skill.verified])));
    setCustomSkills([]);
    setNewSkill("");
  }, [profile]);

  const skills = profile?.verifiedSkills ?? [];
  const confirmedCount = skills.filter((skill) => confirmed[skill.canonical]).length;
  const isDirty = useMemo(() => customSkills.length > 0 || skills.some((skill) => confirmed[skill.canonical] !== (skill.userConfirmed === true && skill.verified)), [confirmed, customSkills.length, skills]);

  function addSkill(): void {
    const value = newSkill.trim().replace(/\s+/g, " ");
    if (!value) return;
    const existing = skills.find((skill) => skill.canonical.toLowerCase() === value.toLowerCase());
    if (existing) setConfirmed((current) => ({ ...current, [existing.canonical]: true }));
    else setCustomSkills((current) => current.some((skill) => skill.toLowerCase() === value.toLowerCase()) ? current : [...current, value]);
    setNewSkill("");
  }

  return (
    <details className="resume-profile-panel">
      <summary className="resume-profile-heading">
        <div>
          <span className="step-label">YOUR RESUME PROFILE</span>
          <h3 id="resume-profile-heading">Review detected skills</h3>
        </div>
        <span className="field-meta" aria-live="polite">
          {loading ? "Reading resume…" : profile ? skills.length ? `${confirmedCount} of ${skills.length} confirmed` : "No skills detected" : "Review profile"}
        </span>
      </summary>
      {loading && <p className="hosted-help-copy" role="status">Reading resume content…</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {!loading && !profile && <p className="hosted-help-copy">Select a DOCX resume to review its recognized skills and experience lines.</p>}
      {profile && (
        <>
          <p className="hosted-help-copy">Confirm a skill only if the resume accurately represents your experience. This profile is private to your account or local app; catalog terms alone never count as experience.</p>
          {skills.length ? (
            <div className="resume-profile-skills">
              {skills.map((skill) => (
                <div className="resume-profile-skill-card" key={skill.canonical}>
                  <label className="resume-profile-skill">
                    <input
                      type="checkbox"
                      checked={confirmed[skill.canonical] ?? false}
                      onChange={(event) => setConfirmed((current) => ({ ...current, [skill.canonical]: event.target.checked }))}
                    />
                    <span><strong>{skill.canonical}</strong>{skill.category && <small>{skill.category}</small>}</span>
                  </label>
                  {skill.evidenceLines?.length ? <details className="resume-skill-evidence"><summary>{skill.evidenceLines.length} source line{skill.evidenceLines.length === 1 ? "" : "s"}</summary>{skill.evidenceLines.map((line) => <blockquote key={line.paragraphId}>{line.text}</blockquote>)}</details> : <small className="resume-skill-evidence-empty">No exact line match found</small>}
                </div>
              ))}
            </div>
          ) : <p className="hosted-empty-state">No catalog skills were detected. Experience bullets are still checked directly during each run.</p>}
          <div className="resume-profile-add-skill">
            <label htmlFor="resume-profile-add-skill">Add a skill you have used</label>
            <div><input id="resume-profile-add-skill" value={newSkill} maxLength={200} onChange={(event) => setNewSkill(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSkill(); } }} placeholder="For example, stakeholder interviews" /><button className="text-button" type="button" disabled={!newSkill.trim()} onClick={addSkill}>Add</button></div>
          </div>
          {customSkills.length > 0 && <div className="resume-profile-custom-skills"><span>New user-confirmed skills</span>{customSkills.map((skill) => <span key={skill}>{skill}<button type="button" aria-label={`Remove ${skill}`} onClick={() => setCustomSkills((current) => current.filter((item) => item !== skill))}>×</button></span>)}</div>}
          <div className="resume-profile-actions">
            <button className="secondary-button" type="button" disabled={!isDirty || saving} onClick={() => void onSave([...skills.map((skill) => ({ canonical: skill.canonical, confirmed: confirmed[skill.canonical] === true })), ...customSkills.map((canonical) => ({ canonical, confirmed: true }))]).catch(() => undefined)}>
              {saving ? "Saving profile…" : "Save confirmations"}
            </button>
            {profile.experienceLines.length > 0 && (
              <details className="resume-profile-evidence">
                <summary>View {profile.experienceLines.length} experience and project lines</summary>
                <ul>{profile.experienceLines.map((line) => <li key={line.paragraphId}><span>{line.section}</span><p>{line.text}</p></li>)}</ul>
              </details>
            )}
          </div>
        </>
      )}
    </details>
  );
}
