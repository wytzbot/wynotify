<?php
/**
 * Plugin Name: WyNotify Push
 * Description: Lightweight WyNotify subscriber button for WordPress.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;
function wynotify_push_settings(){register_setting('wynotify_push','wynotify_workspace_key');register_setting('wynotify_push','wynotify_script_url');}
add_action('admin_init','wynotify_push_settings');
function wynotify_push_menu(){add_options_page('WyNotify Push','WyNotify Push','manage_options','wynotify-push','wynotify_push_page');}
add_action('admin_menu','wynotify_push_menu');
function wynotify_push_page(){if(!current_user_can('manage_options'))return;?><div class="wrap"><h1>WyNotify Push</h1><form method="post" action="options.php"><?php settings_fields('wynotify_push');?><p><label>Workspace key<br><input class="regular-text" name="wynotify_workspace_key" value="<?php echo esc_attr(get_option('wynotify_workspace_key',''));?>"></label></p><p><label>WyNotify dashboard URL<br><input class="regular-text" name="wynotify_script_url" value="<?php echo esc_attr(get_option('wynotify_script_url',''));?>" placeholder="https://YOUR-WYNOTIFY-DOMAIN.com"></label></p><?php submit_button('Save settings');?></form><p>Paste the WyNotify push worker into your site root and use the Integrations page for the exact script. This plugin only stores the public workspace key.</p></div><?php}
function wynotify_push_footer(){ $key=get_option('wynotify_workspace_key',''); $url=trim(get_option('wynotify_script_url','')); if(!$key||!$url)return; $url=esc_url_raw($url); echo '<script src="'.esc_url($url.'/wynotify-register.js').'" data-workspace-key="'.esc_attr($key).'" data-label="Get updates" async></script>'; }
add_action('wp_footer','wynotify_push_footer');
