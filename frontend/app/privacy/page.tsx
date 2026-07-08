import type { Metadata } from "next";

import { LegalPageLayout, LegalSection } from "../../components/public-site";

export const metadata: Metadata = {
  title: "Privacy Policy — Firebook",
  description: "How Firebook collects, uses, and protects information for fire department bookkeeping.",
};

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy">
      <LegalSection title="Overview">
        <p>
          Firebook (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) provides bookkeeping software for fire
          departments. This Privacy Policy describes how we collect, use, store, and protect information when
          you visit our website, request a demo, or use the Firebook service.
        </p>
      </LegalSection>

      <LegalSection title="Information We Collect">
        <p>Depending on how you interact with Firebook, we may collect the following types of information:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-zinc-900">Account information</strong> — name, email address, login
            credentials, and role or permission settings associated with your Firebook account.
          </li>
          <li>
            <strong className="text-zinc-900">Department information</strong> — fire department name, address,
            organizational details, and related configuration used to operate your department&apos;s books.
          </li>
          <li>
            <strong className="text-zinc-900">Bank transaction data</strong> — account balances, transaction
            history, and related financial metadata obtained through Plaid when your department connects a
            financial institution.
          </li>
          <li>
            <strong className="text-zinc-900">Receipt images and uploaded documents</strong> — photos,
            scans, PDFs, and other files you or your team upload for bookkeeping, reconciliation, and
            reporting.
          </li>
          <li>
            <strong className="text-zinc-900">OCR and AI processing data</strong> — text and fields extracted
            from receipts and documents, along with related processing metadata, to help categorize and match
            transactions.
          </li>
          <li>
            <strong className="text-zinc-900">Phone numbers and SMS notifications</strong> — mobile phone
            numbers you provide and SMS delivery status when you enable text notifications in Firebook
            settings.
          </li>
          <li>
            <strong className="text-zinc-900">Demo request submissions</strong> — information submitted
            through our public demo request form, such as your name, department name, phone number, email
            address, and any message you include.
          </li>
          <li>
            <strong className="text-zinc-900">Usage and technical data</strong> — device, browser, and log
            information needed to operate, secure, and improve the service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How We Use Information">
        <p>We use collected information to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Provide, maintain, and improve the Firebook service</li>
          <li>Authenticate users and enforce department permissions</li>
          <li>Import, display, categorize, and reconcile financial transactions</li>
          <li>Process receipts and documents using OCR and related automation</li>
          <li>Generate reports and bookkeeping workflows for your department</li>
          <li>Send transactional SMS notifications you have opted into</li>
          <li>Respond to demo requests and support inquiries</li>
          <li>Protect the security and integrity of our platform</li>
          <li>Comply with legal obligations and enforce our terms</li>
        </ul>
        <p>We do not sell your personal information.</p>
      </LegalSection>

      <LegalSection title="How Information Is Protected">
        <p>
          We use administrative, technical, and organizational safeguards designed to protect information
          against unauthorized access, loss, misuse, or alteration. Access to department data is limited by
          role-based permissions within Firebook. No method of transmission or storage is completely secure,
          and we cannot guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection title="Data Retention">
        <p>
          We retain information for as long as needed to provide the service, support your department&apos;s
          bookkeeping records, meet legal or regulatory requirements, resolve disputes, and enforce our
          agreements. Retention periods may vary based on account status, department settings, and the type
          of data involved.
        </p>
      </LegalSection>

      <LegalSection title="Third-Party Services">
        <p>
          Firebook uses trusted third-party providers to operate the service. These providers process data
          on our behalf and only as needed to deliver their function. Examples include:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-zinc-900">Supabase</strong> — authentication, database, and application
            infrastructure
          </li>
          <li>
            <strong className="text-zinc-900">Plaid</strong> — secure bank account connectivity and
            transaction data
          </li>
          <li>
            <strong className="text-zinc-900">Twilio</strong> — delivery of transactional SMS notifications
          </li>
          <li>
            <strong className="text-zinc-900">Resend</strong> — transactional email delivery
          </li>
          <li>
            <strong className="text-zinc-900">OpenAI</strong> — OCR and document processing assistance
          </li>
        </ul>
        <p>
          Each provider maintains its own privacy and security practices. Where applicable, we configure
          integrations to limit data sharing to what is necessary for the service.
        </p>
      </LegalSection>

      <LegalSection title="Your Choices">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            You may update certain account and department information within Firebook where your role
            permits.
          </li>
          <li>
            You may enable or disable SMS notifications in Firebook settings. You can also reply STOP to
            opt out of SMS messages as described in our{" "}
            <a href="/sms-policy" className="font-semibold text-[#8B0E16] hover:text-[#991B1B]">
              SMS Messaging Policy
            </a>
            .
          </li>
          <li>
            You may disconnect linked financial institutions through Firebook or your institution&apos;s
            connected-app settings, subject to bookkeeping and retention needs.
          </li>
          <li>
            You may contact us with questions or requests regarding your information.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Children&apos;s Privacy">
        <p>
          Firebook is intended for use by fire departments and authorized personnel. It is not directed to
          children under 13, and we do not knowingly collect personal information from children.
        </p>
      </LegalSection>

      <LegalSection title="Changes to This Policy">
        <p>
          We may update this Privacy Policy from time to time. When we do, we will revise the &quot;Last
          updated&quot; date above. Continued use of Firebook after changes become effective constitutes
          acceptance of the updated policy.
        </p>
      </LegalSection>

      <LegalSection title="Contact Us">
        <p>
          If you have questions about this Privacy Policy or our data practices, contact us at{" "}
          <a
            href="mailto:support@firebook.app"
            className="font-semibold text-[#8B0E16] hover:text-[#991B1B]"
          >
            support@firebook.app
          </a>
          .
        </p>
      </LegalSection>
    </LegalPageLayout>
  );
}
