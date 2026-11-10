class Chiselcode < Formula
  desc "ChiselCode CLI"
  homepage "https://github.com/TheAsrada/ChiselCode"
  url "@SOURCE@"
  version "@VERSION@"
  sha256 "@ARCHIVE_SHA256@"
  license "MIT"

  depends_on arch: :x86_64
  depends_on :linux

  def install
    libexec.install "chisel", "skills"
    bin.install_symlink libexec/"chisel"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/chisel --version").strip
  end
end
