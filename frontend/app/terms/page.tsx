import type { Metadata } from "next";

import { LegalPageLayout, LegalSection } from "../../components/public-site";

export const metadata: Metadata = {
  title: "Terms of Service — Hallix",
  description: "Terms governing use of the Hallix fire department bookkeeping service.",
};

export default function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service">
      <LegalSection title="Agreement to Terms">
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of Hallix, including our
          website, application, and related services (collectively, the &quot;Service&quot;). By accessing or
          using Hallix, you agree to these Terms. If you do not agree, do not use the Service.
        </p>
      </LegalSection>

      <LegalSection title="Use of Hallix">
        <p>
          Hallix is designed to help fire departments organize bookkeeping workflows, track transactions,
          manage receipts, reconcile accounts, and prepare reports. You may use the Service only for lawful
          purposes and in accordance with these Terms and applicable laws.
        </p>
        <p>
          You are responsible for ensuring that your use of Hallix complies with your department&apos;s
          policies, bylaws, and any applicable regulatory requirements.
        </p>
      </LegalSection>

      <LegalSection title="Account Responsibility">
        <p>
          You are responsible for maintaining the confidentiality of your login credentials and for all
          activity that occurs under your account. Notify us promptly at{" "}
          <a
            href="mailto:support@hallix.app"
            className="font-semibold text-[#8B0E16] hover:text-[#991B1B]"
          >
            support@hallix.app
          </a>{" "}
          if you believe your account has been compromised.
        </p>
        <p>
          You agree to provide accurate account and department information and to keep that information
          current.
        </p>
      </LegalSection>

      <LegalSection title="Department and User Permissions">
        <p>
          Hallix supports role-based access within a department. Administrators and authorized users are
          responsible for assigning permissions appropriately and for actions taken by users they authorize.
          You may not access another department&apos;s data without permission.
        </p>
      </LegalSection>

      <LegalSection title="Bookkeeping Assistance Only">
        <p>
          Hallix provides software tools to assist with bookkeeping organization and reporting. The Service
          does not replace professional judgment, internal controls, or official recordkeeping processes
          required by your department.
        </p>
        <p>
          <strong className="text-zinc-900">
            Hallix is not legal, tax, accounting, or compliance advice.
          </strong>{" "}
          We do not act as your accountant, attorney, or compliance advisor. You should consult qualified
          professionals for advice specific to your department&apos;s legal, tax, and regulatory obligations.
        </p>
      </LegalSection>

      <LegalSection title="Review Before Filing">
        <p>
          You are solely responsible for reviewing all reports, exports, categorizations, reconciliations,
          and filings generated or assisted by Hallix before submitting them to any government agency,
          auditor, board, or other third party. Hallix does not file documents on your behalf unless
          explicitly stated in a separate written agreement.
        </p>
      </LegalSection>

      <LegalSection title="2% Fund Guidance">
        <p>
          Any guidance, templates, labels, or workflows related to New York State 2% fund reporting or
          similar requirements are provided for informational and organizational purposes only. They are not a
          guarantee of compliance and should not be relied upon as a substitute for official instructions,
          professional advice, or your own review of applicable law and filing requirements.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable Use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Use the Service in any unlawful, fraudulent, or harmful manner</li>
          <li>Attempt to gain unauthorized access to systems, accounts, or data</li>
          <li>Interfere with or disrupt the integrity or performance of the Service</li>
          <li>Upload malware or content you do not have the right to use</li>
          <li>Reverse engineer or misuse the Service except as permitted by law</li>
          <li>Use the Service to send unsolicited marketing messages through Hallix systems</li>
        </ul>
      </LegalSection>

      <LegalSection title="Uploaded Files and Receipts">
        <p>
          You retain responsibility for the accuracy, completeness, and legality of files, receipts, and
          documents you upload. By uploading content, you represent that you have the right to provide that
          content for processing within your department&apos;s Hallix account.
        </p>
        <p>
          We may process uploaded content using automated tools, including OCR and AI-assisted extraction,
          to help organize your records. You are responsible for reviewing extracted data before relying on
          it.
        </p>
      </LegalSection>

      <LegalSection title="Service Availability">
        <p>
          We strive to keep Hallix available and reliable, but the Service may be interrupted for
          maintenance, updates, security measures, or circumstances beyond our reasonable control. We do not
          guarantee uninterrupted or error-free operation.
        </p>
      </LegalSection>

      <LegalSection title="Limitation of Liability">
        <p>
          To the fullest extent permitted by law, Hallix and its operators will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any loss of profits,
          data, goodwill, or business opportunities arising from your use of the Service.
        </p>
        <p>
          To the fullest extent permitted by law, our total liability for any claim arising out of or
          relating to the Service will not exceed the amount you paid us for the Service in the twelve (12)
          months preceding the claim, or one hundred U.S. dollars (USD $100) if no fees were paid.
        </p>
        <p>
          Some jurisdictions do not allow certain limitations of liability, so some of the above limitations
          may not apply to you.
        </p>
      </LegalSection>

      <LegalSection title="Subscription and Payment Terms">
        <p>
          Hallix may introduce paid subscription plans or other fees in the future. If and when paid plans
          become available, additional payment terms will be presented before you are charged. Unless
          otherwise stated at the time of purchase, fees are non-refundable except where required by law.
        </p>
      </LegalSection>

      <LegalSection title="Termination">
        <p>
          You may stop using Hallix at any time. We may suspend or terminate access to the Service if you
          violate these Terms, create risk or legal exposure, or if we discontinue the Service. Provisions
          that by their nature should survive termination will survive, including disclaimers and limitations
          of liability.
        </p>
      </LegalSection>

      <LegalSection title="Changes to These Terms">
        <p>
          We may update these Terms from time to time. When we do, we will revise the &quot;Last updated&quot;
          date above. Continued use of the Service after changes become effective constitutes acceptance of
          the updated Terms.
        </p>
      </LegalSection>

      <LegalSection title="Contact Us">
        <p>
          Questions about these Terms may be sent to{" "}
          <a
            href="mailto:support@hallix.app"
            className="font-semibold text-[#8B0E16] hover:text-[#991B1B]"
          >
            support@hallix.app
          </a>
          .
        </p>
      </LegalSection>
    </LegalPageLayout>
  );
}
