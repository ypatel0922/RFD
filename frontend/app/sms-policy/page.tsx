import type { Metadata } from "next";

import { LegalPageLayout, LegalSection } from "../../components/public-site";

export const metadata: Metadata = {
  title: "SMS Messaging Policy — Firebook",
  description: "How Firebook uses SMS and MMS for transactional notifications to fire departments.",
};

export default function SmsPolicyPage() {
  return (
    <LegalPageLayout title="SMS Messaging Policy">
      <LegalSection title="Overview">
        <p>
          Firebook may send transactional SMS and MMS messages to mobile phone numbers provided by users who
          have opted in to text notifications. This policy describes how those messages are used.
        </p>
      </LegalSection>

      <LegalSection title="Types of Messages">
        <p>Firebook uses SMS and MMS for transactional service communications only. Examples include:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Receipt reminders</li>
          <li>Missing documentation alerts</li>
          <li>Transaction follow-ups</li>
          <li>Account and security notifications</li>
        </ul>
        <p>
          Firebook does not use SMS for unrelated marketing campaigns. Messages are sent to support your
          department&apos;s use of the Firebook service.
        </p>
      </LegalSection>

      <LegalSection title="How You Opt In">
        <p>
          You opt in to receive SMS notifications by enabling SMS notifications in your Firebook account
          settings and providing a valid mobile phone number. By enabling SMS notifications, you consent to
          receive transactional text messages related to your Firebook account and department activity.
        </p>
        <p>
          Message frequency varies based on your department&apos;s activity, notification settings, and
          bookkeeping workflows.
        </p>
      </LegalSection>

      <LegalSection title="Message and Data Rates">
        <p>
          Message and data rates may apply depending on your mobile carrier and plan. Firebook does not
          charge separate fees for standard transactional SMS notifications beyond any applicable Firebook
          subscription or service fees.
        </p>
      </LegalSection>

      <LegalSection title="How to Get Help or Opt Out">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Reply <strong className="text-zinc-900">STOP</strong> to unsubscribe from Firebook SMS messages.
          </li>
          <li>
            Reply <strong className="text-zinc-900">HELP</strong> for help with SMS messaging.
          </li>
          <li>
            You may also disable SMS notifications in your Firebook settings or contact us at{" "}
            <a
              href="mailto:support@firebook.app"
              className="font-semibold text-[#8B0E16] hover:text-[#991B1B]"
            >
              support@firebook.app
            </a>
            .
          </li>
        </ul>
        <p>
          After you opt out, you may still receive a final confirmation message. Opting out of SMS does not
          affect other Firebook communications, such as email notifications you have enabled.
        </p>
      </LegalSection>

      <LegalSection title="Phone Number Use and Sharing">
        <p>
          Phone numbers collected for SMS notifications are used to deliver transactional Firebook messages
          and to support account-related communications. Firebook does not sell or share phone numbers with
          third parties for their independent marketing purposes.
        </p>
        <p>
          We use service providers such as Twilio to deliver messages on our behalf. Those providers process
          phone numbers only as needed to transmit messages and maintain delivery records.
        </p>
      </LegalSection>

      <LegalSection title="Supported Carriers">
        <p>
          SMS delivery depends on your wireless carrier and network availability. Carriers are not liable for
          delayed or undelivered messages. Supported carriers may change over time.
        </p>
      </LegalSection>

      <LegalSection title="Changes to This Policy">
        <p>
          We may update this SMS Messaging Policy from time to time. When we do, we will revise the &quot;Last
          updated&quot; date above. Continued use of SMS notifications after changes become effective
          constitutes acceptance of the updated policy, subject to applicable law and your opt-out rights.
        </p>
      </LegalSection>

      <LegalSection title="Contact Us">
        <p>
          For questions about Firebook SMS messaging, contact{" "}
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
