import Image from "next/image";

type BrandLogoProps = {
  variant?: "full" | "icon";
  /** White logo for dark backgrounds; navy logo for light backgrounds. */
  tone?: "light" | "dark";
  className?: string;
  priority?: boolean;
};

const LOGO_SOURCES = {
  light: "/logo-light.png",
  dark: "/logo-dark.png",
} as const;

export function BrandLogo({
  variant = "full",
  tone = "light",
  className,
  priority = false,
}: BrandLogoProps) {
  if (variant === "icon") {
    return (
      <Image
        src="/icon.png"
        alt="Hallix"
        width={261}
        height={261}
        className={className}
        priority={priority}
      />
    );
  }

  return (
    <Image
      src={LOGO_SOURCES[tone]}
      alt="Hallix"
      width={1024}
      height={207}
      className={className}
      priority={priority}
    />
  );
}
