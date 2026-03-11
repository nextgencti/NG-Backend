/**
 * Common HTML layout for emails with premium styling.
 * Optimized for "NextGen Computer Training Institute Muskara"
 * Final UI Refinement: Seamless header integration and dark mode friendliness.
 * @param {string} title - The title of the email
 * @param {string} content - The main HTML content
 * @returns {string} - Full HTML string
 */
const emailLayout = (title, content) => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #f4f7fa;
            color: #1a1a1b;
            -webkit-font-smoothing: antialiased;
        }
        .wrapper {
            width: 100%;
            background-color: #f4f7fa;
            padding: 20px 0;
        }
        .main {
            background-color: #ffffff;
            margin: 0 auto;
            width: 100%;
            max-width: 600px;
            border-spacing: 0;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid #e5e7eb;
        }
        .header {
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            padding: 60px 20px;
            text-align: center;
        }
        .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 24px;
            font-weight: 800;
            letter-spacing: -0.5px;
            text-transform: uppercase;
        }
        .header p {
            color: rgba(255, 255, 255, 0.9);
            font-size: 14px;
            margin-top: 8px;
            font-weight: 500;
            letter-spacing: 1px;
        }
        .content {
            padding: 40px 35px;
            line-height: 1.6;
            font-size: 16px;
            color: #374151;
            background-color: #ffffff;
        }
        .footer {
            padding: 30px;
            text-align: center;
            font-size: 13px;
            color: #6b7280;
            background-color: #ffffff;
            border-top: 1px solid #f1f5f9;
        }
        .button {
            display: inline-block;
            padding: 14px 28px;
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            color: #ffffff !important;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 700;
            margin-top: 25px;
            text-align: center;
        }
        .otp-box {
            background: #f8fafc;
            padding: 30px;
            border-radius: 12px;
            border: 2px dotted #4f46e5;
            margin: 35px 0;
            text-align: center;
        }
        .otp-code {
            font-size: 42px;
            font-weight: 800;
            color: #4f46e5;
            letter-spacing: 12px;
            margin: 0;
        }
        .website-link-box {
            display: inline-block;
            margin-top: 20px;
            padding: 8px 16px;
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            color: #64748b;
        }
        .website-link-box a {
            color: #4f46e5;
            text-decoration: none;
            font-weight: 600;
        }
        @media (prefers-color-scheme: dark) {
            body { background-color: #0f172a; }
            .wrapper { background-color: #0f172a; }
            .main { 
                background-color: #1e293b; 
                border-color: #334155; 
            }
            .content { 
                background-color: #1e293b; 
                color: #e2e8f0; 
            }
            .footer { 
                background-color: #1e293b; 
                color: #94a3b8;
                border-top-color: #334155;
            }
            .otp-box { background: #0f172a; border-color: #6366f1; }
            .website-link-box { background-color: #0f172a; border-color: #334155; }
        }
        @media only screen and (max-width: 600px) {
            .content { padding: 30px 20px; }
            .header { padding: 40px 15px; }
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <table class="main" width="100%" align="center">
            <tr>
                <td class="header">
                    <h1>NextGen Computer</h1>
                    <p>Training Institute Muskara</p>
                </td>
            </tr>
            <tr>
                <td class="content">
                    ${content}
                </td>
            </tr>
            <tr>
                <td class="footer">
                    <strong>NextGen Computer Training Institute Muskara</strong><br>
                    Empowering Future Professionals<br>
                    
                    <div class="website-link-box">
                        Visit us: <a href="https://ngcti.in">ngcti.in</a>
                    </div>

                    <div style="margin-top: 20px; font-size: 11px;">
                        &copy; ${new Date().getFullYear()} All rights reserved.
                    </div>
                </td>
            </tr>
        </table>
    </div>
</body>
</html>
  `;
};

module.exports = emailLayout;
